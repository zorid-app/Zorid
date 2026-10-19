import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {open,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {generate,sha256,json} from './workload.mjs';
import {generatedPlan,expectedGenerated,ORACLE_VERSION,CLOCK_ORACLE,SOURCE,SNAPSHOT} from './generated-bases-oracle.mjs';
const PROFILE_HASHES=Object.freeze({100:'2e267b38b5ec5d61c3fdf07eab0daa1f0d39e98b6038d354bc835a4b20c91859',10000:'9d8b3562ca75349adb08e41e9af7c09138a8963e07f8698eaa46e2eae02c2085'});
const uint=(value,max=Number.MAX_SAFE_INTEGER)=>assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=max,'bounded integer required');
const finite=value=>assert.ok(Number.isFinite(value)&&value>=0,'nonnegative finite timing required');
export function validateGeneratedResult(result,caseId,manifest){
  const expected=expectedGenerated(caseId,manifest);assert.deepEqual(result.snapshotId,SNAPSHOT);assert.equal(result.view.name,expected.viewName);
  assert.deepEqual(result.properties,expected.properties);assert.deepEqual(result.counts,expected.counts);assert.deepEqual(result.groups,expected.groups);assert.deepEqual(result.groupOptions,expected.groupOptions);assert.deepEqual(result.diagnostics,expected.diagnostics);
  assert.equal(result.relationshipsAvailable,true);assert.equal(result.metadataComplete,true);assert.deepEqual(result.metadataIssues,expected.metadataIssues);uint(result.stepsUsed,2000000);
  assert.equal(result.rows.length,expected.rows.length);
  for(let i=0;i<expected.rows.length;i++){const actual=result.rows[i],row=expected.rows[i];assert.equal(actual.entryId,row.entryId);assert.equal(actual.revision,row.revision);assert.equal(actual.path,row.path);
    for(const [key,value]of Object.entries(row.values))assert.deepEqual(actual.values[key],value,`${caseId}: ${row.path} ${key}`);
  }
  return {rows:result.rows.length,counts:result.counts,stepsUsed:result.stepsUsed,correctness:'complete-arithmetic-row-order/groups/counts/declared-cells/source-witness-oracle',supplementalResultSha256:sha256(JSON.stringify(result)),hashScope:'actual full typed result hash, not independent full-result expectation'};
}
export class GeneratedBasesValidator{
  constructor(fixture,plan,{preparationCache=false}={}){this.fixture=fixture;this.plan=plan;this.setup=null;this.generation=null;this.programs=[];this.results=[];this.pending=null;this.done=false;this.preparationCache=preparationCache;this.baselineResults=new Map();this.cachePrograms=[];this.cacheResults=[];this.cachePending=null;this.cacheDone=false;}
  identity(e){assert.deepEqual(e.source,SOURCE);assert.deepEqual(e.snapshot,SNAPSHOT);}
  acceptCache(event){
    assert.equal(this.preparationCache,true,'cache output requires explicit opt-in');assert.equal(this.results.length,8,'uncached baseline must finish first');assert.equal(this.pending,null);assert.equal(this.cacheDone,false,'output after cache acknowledgment');
    if(event.type==='cache-program'){
      assert.equal(this.cacheResults.length,0);assert.equal(this.cachePending,null);const index=this.cachePrograms.length,expected=this.plan.programs[Math.floor(index/2)];assert.ok(expected);assert.equal(event.programId,expected.id);assert.equal(event.lookup,index%2?'repeat':'first');assert.equal(event.sourceBytes,Buffer.byteLength(expected.source));assert.equal(event.outcome,index%2?'hit':'miss');finite(event.compileMs);uint(event.cacheWorkUsed,2000000);assert.equal(event.workUsed,0);if(index%2)assert.equal(event.sameProgram,true);else assert.equal(event.sameProgram,undefined);this.cachePrograms.push(event);return;
    }
    assert.equal(this.cachePrograms.length,10,'all exact-source compile lookups required');
    if(event.type==='cache-done'){this.identity(event);assert.equal(this.cachePending,null);assert.equal(this.cacheResults.length,16);assert.equal(event.programLookups,10);assert.equal(event.invocations,16);this.cacheDone=true;return;}
    const index=this.cacheResults.length,expected=this.plan.invocations[index%8];assert.ok(index<16);assert.equal(event.pass,Math.floor(index/8)+1);assert.equal(event.caseId,expected.id);
    if(event.type==='cache-result'){
      assert.equal(this.cachePending,null);this.identity(event);assert.equal(event.programId,expected.programId);assert.deepEqual(event.options,expected.options);for(const key of ['preparationMs','evaluationMs'])finite(event[key]);assert.ok(['hit','miss','uncached'].includes(event.preparationOutcome));uint(event.preparationWorkUsed,2000000);uint(event.cacheWorkUsed,2000000);
      const checked=validateGeneratedResult(event.result,event.caseId,this.fixture.manifest),baseline=this.baselineResults.get(event.caseId);assert.ok(baseline,'successful uncached counterpart required');assert.deepEqual({...event.result,stepsUsed:0},{...baseline,stepsUsed:0},'cached full typed result differs from uncached');assert.ok(event.result.stepsUsed>=event.preparationWorkUsed);assert.ok(event.result.stepsUsed<=baseline.stepsUsed,'prepared semantic work exceeded uncached work');
      this.cachePending={pass:event.pass,caseId:event.caseId,programId:event.programId,preparationMs:event.preparationMs,evaluationMs:event.evaluationMs,preparationOutcome:event.preparationOutcome,preparationWorkUsed:event.preparationWorkUsed,cacheWorkUsed:event.cacheWorkUsed,evaluationWorkUsed:event.result.stepsUsed-event.preparationWorkUsed,uncachedStepsUsed:baseline.stepsUsed,semanticWorkReduced:event.result.stepsUsed<baseline.stepsUsed,...checked,fullTypedEquivalentExceptSteps:true};return;
    }
    assert.equal(event.type,'cache-measurement');assert.ok(this.cachePending);finite(event.resultOutputMs);this.cacheResults.push({...this.cachePending,resultOutputMs:event.resultOutputMs});this.cachePending=null;
  }
  accept(event){
    assert.equal(this.done,false,'output after final acknowledgment');if(event.type.startsWith('cache-'))return this.acceptCache(event);if(event.type==='error')throw Object.assign(Error(`generated Base core failed ${event.phase}: ${event.detail}`),{phase:event.phase,kind:'core-failure'});
    if(event.type==='setup'){assert.equal(this.setup,null);assert.equal(event.noteCount,this.fixture.manifest.noteCount);assert.equal(event.entries,this.fixture.manifest.entries.length);assert.equal(event.sourceBytes,this.fixture.manifest.entries.reduce((n,e)=>n+e.bytes,0));assert.equal(event.manifestBytes,Buffer.byteLength(json(this.fixture.manifest)));assert.equal(event.planBytes,Buffer.byteLength(json(this.plan)));assert.equal(typeof event.debugAssertions,'boolean');for(const k of ['setupMs','sourceReadMs','sourceDecodeMs'])finite(event[k]);this.setup=event;return;}
    assert.ok(this.setup,'setup acknowledgment required');
    if(event.type==='generation'){assert.equal(this.generation,null);this.identity(event);assert.equal(event.records,this.fixture.manifest.entries.length);assert.equal(event.fileFacts,event.records);assert.equal(event.parseInvocations,this.fixture.manifest.noteCount);assert.equal(event.coverageComplete,true);uint(event.metadataBytes,64*1024*1024);uint(event.pumpResets);finite(event.generationBuildMs);this.generation=event;return;}
    assert.ok(this.generation,'full linked generation required');
    if(event.type==='program'){assert.equal(this.pending,null);assert.equal(this.results.length,0);const expected=this.plan.programs[this.programs.length];assert.ok(expected);assert.equal(event.programId,expected.id);assert.equal(event.sourceBytes,Buffer.byteLength(expected.source));finite(event.yamlAndConfigurationMs);this.programs.push(event);return;}
    assert.equal(this.programs.length,5,'all programs must compile before queries');
    if(event.type==='done'){if(this.preparationCache)assert.equal(this.cacheDone,true,'complete cache observation required');this.identity(event);assert.equal(this.pending,null);assert.equal(this.results.length,8);assert.equal(event.invocations,8);assert.equal(event.successes,this.results.filter(r=>r.outcome==='ok').length);assert.equal(event.rejections,this.results.filter(r=>r.outcome==='rejected').length);this.done=true;return;}
    const expected=this.plan.invocations[this.results.length];assert.ok(expected);assert.equal(event.caseId,expected.id);
    if(event.type==='result'){assert.equal(this.pending,null);this.identity(event);assert.equal(event.programId,expected.programId);assert.deepEqual(event.options,expected.options);finite(event.queryMs);
      if(event.outcome==='ok'){assert.equal(event.error,undefined);if(this.preparationCache)this.baselineResults.set(event.caseId,event.result);this.pending={caseId:event.caseId,programId:event.programId,queryMs:event.queryMs,outcome:'ok',...validateGeneratedResult(event.result,event.caseId,this.fixture.manifest)};}
      else{assert.equal(event.outcome,'rejected');assert.equal(event.result,undefined);assert.equal(typeof event.error?.code,'string');assert.equal(typeof event.error.message,'string');this.pending={caseId:event.caseId,programId:event.programId,elapsedToRejectionMs:event.queryMs,outcome:'rejected',error:event.error,correctness:'semantic oracle unestablished; no result returned',phase:'query_generation'};}
      return;
    }
    assert.equal(event.type,'measurement');assert.ok(this.pending);finite(event.resultOutputMs);this.results.push({...this.pending,resultOutputMs:event.resultOutputMs});this.pending=null;
  }
  status(){if(!this.done)return 'failed-or-incomplete';const rejected=this.results.filter(r=>r.outcome==='rejected');if(!rejected.length)return 'passed';return this.fixture.manifest.noteCount===10000&&rejected.every(r=>r.error.code==='budget')?'limited-incomplete':'failed-or-incomplete';}
}
async function verifyFixture(fixture){for(const entry of fixture.manifest.entries){const bytes=await readFile(path.join(fixture.vault,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha256(bytes),entry.sha256,`source changed: ${entry.path}`);}}
async function clockProvenance(){const bytes=await readFile(new URL(`../../tests/fixtures/document-semantics/bases/${CLOCK_ORACLE.file}`,import.meta.url));assert.equal(sha256(bytes),CLOCK_ORACLE.sha256);const c=JSON.parse(bytes).cases.find(c=>c.id===CLOCK_ORACLE.id);assert.equal(c.request.expression,CLOCK_ORACLE.expression);assert.equal(c.request.options.clockMs,CLOCK_ORACLE.clockMs);assert.equal(c.request.options.timezone,CLOCK_ORACLE.timezone);assert.equal(c.expected.value,CLOCK_ORACLE.expected);return CLOCK_ORACLE;}
async function execute(binary,args,validator,log,timeoutMs){
  const start=performance.now(),child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});let timedOut=false,killTimer,total=0,line='',stderr='',validationError;
  const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);const closed=new Promise(resolve=>{child.once('error',error=>resolve({spawnError:String(error)}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+chunk.length>1024*1024){validationError??=Error('stderr bound');stop();}else stderr+=chunk.toString('utf8');});const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for await(const chunk of child.stdout){total+=chunk.length;if(total>128*1024*1024)throw Error('stdout bound');await log.write(chunk);line+=decoder.decode(chunk,{stream:true});let split;while((split=line.indexOf('\n'))>=0){const raw=line.slice(0,split);line=line.slice(split+1);if(Buffer.byteLength(raw)>16*1024*1024)throw Error('event bound');validator.accept(JSON.parse(raw));}if(Buffer.byteLength(line)>16*1024*1024)throw Error('event bound');}line+=decoder.decode();assert.equal(line,'','truncated final record');}
  catch(error){validationError??=error;stop();child.stdout.resume();}
  const result=await closed;clearTimeout(timer);clearTimeout(killTimer);return {...result,wallMs:performance.now()-start,timedOut,stdoutBytes:total,stderr,...(validationError?{validationError:{message:validationError.message,kind:validationError.kind,phase:validationError.phase}}:{})};
}
export async function runGeneratedBases({out,binary,notes=100,timeoutMs=60000,buildSha='unknown',buildMode='unknown',preparationCache=false}){
  assert.ok([100,10000].includes(notes),'only approved100/10000 profiles');assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=300000);assert.match(buildSha,/^(unknown|[a-f0-9]{40})$/);assert.ok(['debug','release','unknown'].includes(buildMode));assert.equal(typeof preparationCache,'boolean');
  binary=await realpath(binary);assert.ok((await stat(binary)).isFile());const binaryHash=sha256(await readFile(binary)),clockOracle=await clockProvenance(),plan=generatedPlan(),start=performance.now(),mask=process.umask(0o077);let fixture;
  try{fixture=await generate(out,notes);}finally{process.umask(mask);}
  const generationMs=performance.now()-start;assert.equal(fixture.fixtureHash,PROFILE_HASHES[notes],'frozen workload profile changed');
  const planBytes=json(plan),planHash=sha256(planBytes);await writeFile(path.join(fixture.out,'generated-bases-plan.json'),planBytes,{flag:'wx',mode:0o600});
  const report={schemaVersion:1,status:'running',scope:'full frozen linked generation; generated arithmetic Base oracle for100/10000, not production/cache/foreground acceptance',noteCount:notes,fixtureHash:fixture.fixtureHash,oracleVersion:ORACLE_VERSION,planSha256:planHash,clockOracle,
    binary:{path:binary,sha256:binaryHash,buildSha,buildMode,provenance:'caller source/build label plus measured executable pre/post identity; source correspondence not inferred'},wrapperSha256:sha256(await readFile(new URL(import.meta.url))),oracleSha256:sha256(await readFile(new URL('./generated-bases-oracle.mjs',import.meta.url))),workloadSha256:sha256(await readFile(new URL('./workload.mjs',import.meta.url))),
    environment:{node:process.version,os:os.release(),platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMemory:os.totalmem()},setup:{fixtureGenerationMs:generationMs},sourcePreserved:false,results:[],
    sourceInference:{status:'historical baseline inference, not current runtime evidence',reason:'Before prepared namespace lookups (pre-8b17233e), candidates_checked charged at least manifest length per link; current actual stepsUsed and semantic outcomes supersede this baseline formula',minimumResolverWork:Math.ceil(notes/2)*(notes+3),queryWorkCeiling:2000000},
    limitations:['budget rejection establishes no row/no-match semantics and is not a passed performance measurement; only successful results validate the semantic oracle','known binary body excluded; no OCR/body search claim','selected typed cells/groups/counts are independent; actual full-result hashes are supplemental','programs compile once and repeat/context/view invocations reuse existing public objects, not an implemented result-cache proof','generation setup includes current parser/hash/witness work; query_generation includes repeated full graph/preparation work','OS cache/load uncontrolled; no peak RSS/CPU/internal-cache/queue counters or client/foreground/cancellation observations']};
  if(preparationCache){report.scope='ordered pure-engine uncached/first/hit preparation and program observations on the unchanged frozen generation';report.preparationCache={requested:true,phaseOrder:'uncached baseline, exact-source first/repeat compilation, two ordered full cached invocation passes',limitations:['in-process ordered observations; existing AST/regex and OS caches may already be warm','wall times are observations, not controlled speedup estimates or CPU/resource measurements','actual Uncached outcomes remain valid under unchanged cache caps; no forced hits','no evaluated-answer reuse, host pin/source admission, native/browser/UI or foreground acceptance']};}
  const validator=new GeneratedBasesValidator(fixture,plan,{preparationCache}),log=await open(path.join(fixture.out,'generated-bases.stdout.ndjson'),'wx',0o600);
  try{
    await verifyFixture(fixture);report.setup.sourcesVerifiedBefore=true;
    const args=['--fixture',fixture.out];if(preparationCache)args.push('--preparation-cache');
    report.process=await execute(binary,args,validator,log,timeoutMs);report.setup.core=validator.setup;report.generation=validator.generation;report.programs=validator.programs;report.results=validator.results;
    if(preparationCache)Object.assign(report.preparationCache,{complete:validator.cacheDone,programs:validator.cachePrograms,results:validator.cacheResults,preparationHits:validator.cacheResults.filter(r=>r.preparationOutcome==='hit').length,preparationMisses:validator.cacheResults.filter(r=>r.preparationOutcome==='miss').length,preparationUncached:validator.cacheResults.filter(r=>r.preparationOutcome==='uncached').length});
    await verifyFixture(fixture);assert.equal(sha256(await readFile(path.join(fixture.out,'generated-bases-plan.json'))),planHash);assert.equal(sha256(await readFile(path.join(fixture.out,'manifest.json'))),fixture.fixtureHash);report.sourcePreserved=true;
    report.binary.afterSha256=sha256(await readFile(binary));report.binary.stable=report.binary.afterSha256===binaryHash;assert.equal(report.binary.stable,true);
    assert.equal(report.process.spawnError,undefined);assert.equal(report.process.validationError,undefined,report.process.validationError?.message);assert.equal(report.process.timedOut,false);assert.equal(report.process.signal,null);assert.equal(report.process.exitCode,0);assert.equal(validator.done,true);report.status=validator.status();
  }catch(error){report.status='failed-or-incomplete';report.error={message:error.message,kind:error.kind,phase:error.phase};}
  finally{await log.close();await writeFile(path.join(fixture.out,'generated-bases-report.json'),json(report),{flag:'wx',mode:0o600});}
  return {out:fixture.out,report};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const {values}=parseArgs({options:{out:{type:'string'},bases:{type:'string'},notes:{type:'string',default:'100'},'timeout-ms':{type:'string',default:'60000'},'build-sha':{type:'string',default:'unknown'},'build-mode':{type:'string',default:'unknown'},'preparation-cache':{type:'boolean'}}});if(!values.out||!values.bases)throw Error('Use --out NEW_DIRECTORY --bases ALREADY_BUILT_GENERATED_EXAMPLE');const r=await runGeneratedBases({out:values.out,binary:values.bases,notes:Number(values.notes),timeoutMs:Number(values['timeout-ms']),buildSha:values['build-sha'],buildMode:values['build-mode'],preparationCache:values['preparation-cache']??false});console.log(json({out:r.out,status:r.report.status,report:path.join(r.out,'generated-bases-report.json')}));if(r.report.status!=='passed')process.exitCode=1;}
