import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {generate,sha256,json,queries,literalOracle,expectedCount,checkCount} from './workload.mjs';

export function validateSearch(reply,query,count,byPath,snapshot,source){
  assert.deepEqual(reply.snapshot,snapshot,'query must retain the built generation');
  assert.deepEqual(reply.source,source,'query source must retain the exact build watermark');
  assert.equal(typeof reply.coverageComplete,'boolean');assert.equal(typeof reply.scanComplete,'boolean');
  assert.equal(reply.complete,reply.scanComplete&&reply.coverageComplete);
  assert.equal(reply.truncated,!reply.scanComplete);assert.equal(reply.value.hasNext,!reply.scanComplete);
  assert.ok(Array.isArray(reply.value.hits));assert.ok(reply.value.hits.length<=1000);
  const oracle=literalOracle(query,count);let verified=0;
  for(const actual of reply.value.hits){const next=oracle.next();assert.equal(next.done,false,'unexpected extra hit');const expected=next.value,mapped=byPath.get(expected.path);
    assert.ok(mapped,'missing exact source mapping');assert.deepEqual(actual.entry,mapped);
    assert.equal(actual.line,expected.line);assert.deepEqual(actual.range,expected.range);verified++;}
  const total=expectedCount(query,count);assert.ok(verified<=total);
  if(reply.scanComplete)assert.equal(verified,total,'complete scan omitted expected matches');
  return {queryId:query.id,expectedFiles:total,verifiedHits:verified,correctness:reply.scanComplete?'complete-oracle':'ordered-prefix-only',coverageComplete:reply.coverageComplete,scanComplete:reply.scanComplete,complete:reply.complete,
    pages:reply.value.pages,documents:reply.value.documents,sourceBytes:reply.value.sourceBytes,snapshot:reply.snapshot,source:reply.source};
}
export function liveImportCoverage(listing,expectedPaths){
  assert.ok(Array.isArray(listing.entries));const ids=new Set(),paths=new Set();
  const files=listing.entries.filter(e=>e.kind==='file'&&!e.deleted).map(entry=>{
    assert.ok(expectedPaths.has(entry.path),'unexpected file in owned source fixture');
    assert.equal(typeof entry.id,'string');assert.equal(typeof entry.revision,'string');
    assert.ok(!ids.has(entry.id)&&!paths.has(entry.path),'duplicate imported source identity');ids.add(entry.id);paths.add(entry.path);
    return {path:entry.path,id:entry.id,revision:entry.revision};
  });files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return files;
}
function assertImportContinuity(before,after){
  if(before){const byPath=new Map(after.map(e=>[e.path,e]));for(const entry of before)assert.deepEqual(byPath.get(entry.path),entry,'committed source changed during static import');}
}
export function finalImportCoverage(listing,expectedPaths,before){
  const after=liveImportCoverage(listing,expectedPaths);assert.equal(after.length,expectedPaths.size,'final source map must include every generated file');assertImportContinuity(before,after);return after;
}
export function importProgress(previous,current,before,after){
  assertImportContinuity(before,after);
  const sourceGrew=after.length>(before?.length??0);
  const inventoryGrew=previous&&current.run?.scan_id===previous.run?.scan_id&&(current.run.observed>previous.run.observed||current.run.finished&&!previous.run.finished);
  return sourceGrew||!!inventoryGrew;
}
export function buildSource(cold){
  assert.equal(cold.observedIndex.state,'ready');assert.deepEqual(cold.observedIndex.snapshot,cold.snapshot);
  assert.equal(cold.observedIndex.coveredWatermark,cold.observedIndex.observedSourceHead);
  assert.match(cold.observedIndex.coveredWatermark,/^[1-9][0-9]*$/);
  return {localStoreId:cold.snapshot.localStoreId,watermark:cold.observedIndex.coveredWatermark};
}
export function validateWarmStatus(warm,cold){
  assert.equal(warm.localStoreId,cold.snapshot.localStoreId);assert.deepEqual(warm.status,cold.observedIndex,'warm restart must retain snapshot, source watermark and coverage');
}
export function decodeReadyFrame(bytes){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>=8);const header=bytes.readUInt32BE(0),body=bytes.readUInt32BE(4);
  assert.ok(header>0&&header<=1024*1024);assert.equal(body,0);assert.equal(bytes.length,8+header);
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(8)));
  assert.equal(value.version,1);assert.equal(value.request_id,'0');assert.equal(value.ok,true);
  assert.equal(value.result.transport,'zorid-native-stdio');for(const capability of ['documents','rescan','local_family_status'])assert.ok(value.result.capabilities.includes(capability));
  assert.equal(typeof value.result.reconciliation.complete,'boolean');return value.result;
}
async function verifyFiles(fixture){
  for(const entry of fixture.manifest.entries){const bytes=await readFile(path.join(fixture.vault,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha256(bytes),entry.sha256,`fixture source changed: ${entry.path}`);}
}
export async function invoke(binary,args,{environment,timeoutMs,maxOutputBytes=64*1024*1024,stdoutEncoding='utf8'}){
  const started=performance.now();return await new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{env:environment,stdio:['ignore','pipe','pipe']});let bytes=0,overflow=false,timedOut=false,killTimer;
    const stdout=[],stderr=[];const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),1000);};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const collect=target=>chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes){overflow=true;stop();}else target.push(chunk);};
    child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
    child.once('error',error=>{clearTimeout(timer);clearTimeout(killTimer);reject(error);});
    child.once('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolve({args,wallMs:performance.now()-started,exitCode,signal,timedOut,outputLimit:overflow,stdout:stdoutEncoding==='buffer'?Buffer.concat(stdout):Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')});});
  });
}
export async function runBaseline({out,binary,notes=100,timeoutMs=60000,buildSha='unknown',buildMode='unknown',samples=1,stress=false,nativeHost,maxImportPasses=32}){
  checkCount(notes);if(notes===100000&&!stress)throw Error('100k requires explicit --stress; retain expected resource limits');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw Error('timeout-ms must be in100..300000');
  if(!Number.isSafeInteger(maxImportPasses)||maxImportPasses<1||maxImportPasses>1000)throw Error('max-import-passes must be in1..1000');
  if(!Number.isSafeInteger(samples)||samples<1||samples>20)throw Error('samples must be in1..20');
  if(process.platform!=='darwin')throw Error('This native runtime baseline currently targets macOS only');
  binary=await realpath(binary);assert.ok((await stat(binary)).isFile());
  if(nativeHost)nativeHost=await realpath(nativeHost);
  const generationStarted=performance.now(),fixture=await generate(out,notes),generationMs=performance.now()-generationStarted;
  const localData=path.join(fixture.out,'local-data');await mkdir(localData);
  const report={schemaVersion:1,scope:'standalone CLI on macOS; real native SQLite/source/index commands, no renderer/web/mobile responsiveness claim',status:'running',fixtureHash:fixture.fixtureHash,noteCount:notes,noteBytes:fixture.manifest.noteBytes,
    binary:{path:binary,sha256:sha256(await readFile(binary)),buildSha,buildMode,provenance:'buildSha/mode supplied by caller; executable bytes hashed, not inferred source correspondence'},
    environment:{node:process.version,os:os.release(),platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMemory:os.totalmem(),executor:'existing CLI implementation; no configured worker pool'},
    setup:{generationMs,sourceAdmission:nativeHost?'public desktop-host --initialize-local + CLI rescan, local-family native authority; no Electron renderer claim':'public init + rescan, legacy non-enrolled native authority; no enrolled-family or desktop path claim',presentation:'manifest timestamps are synthetic. Current native source admission supplies actual presentation; no fixed-ctime claim and no ctime-dependent query oracle.'},
    limitations:['first bounded tool, not complete S1.0 or performance acceptance','each command restarts CLI; repeated queries do not reuse one process-local pin','OS page cache uncontrolled','internal phase/cancellation/peak RSS metrics unavailable in this runner; process wall time includes startup','only literal oracle exercised; no Base/operator/regex or editor foreground gate','no source-corruption/cache-deletion/interruption/incremental mutation scenarios executed'],commands:[],queries:[],filesystemSourcePreserved:false,authoritySamples:[]};
  if(nativeHost)report.nativeHost={path:nativeHost,sha256:sha256(await readFile(nativeHost))};
  const environment={...process.env,ZORID_LOCAL_DATA_DIR:localData};delete environment.ZORID_IPC_ENDPOINT;delete environment.DISPLAY;
  async function command(label,args){
    const result=await invoke(binary,['--vault',fixture.vault,...args],{environment,timeoutMs});
    await writeFile(path.join(fixture.out,`${String(report.commands.length).padStart(2,'0')}-${label}.stdout.json`),result.stdout);
    await writeFile(path.join(fixture.out,`${String(report.commands.length).padStart(2,'0')}-${label}.stderr.txt`),result.stderr);
    const entry={label,args,result:{...result,stdoutBytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr)}};delete entry.result.stdout;delete entry.result.stderr;
    report.commands.push(entry);
    if(result.timedOut||result.outputLimit||result.signal)throw Object.assign(Error(`bounded command stopped: ${label}`),{kind:'bounded-stop',label});
    let envelope;try{envelope=JSON.parse(result.exitCode===0?result.stdout:result.stderr);}catch{throw Error(`invalid CLI JSON for ${label}`);}
    if(result.exitCode!==0||envelope.ok!==true){entry.error=envelope.error;throw Object.assign(Error(`CLI rejected ${label}: ${envelope.error?.code??'unknown'}`),{kind:'cli-rejection',code:envelope.error?.code,label});}
    assert.equal(envelope.version,1);return envelope.result;
  }
  try{
    if(nativeHost){
      const result=await invoke(nativeHost,['--vault',fixture.vault,'--initialize-local'],{environment,timeoutMs,stdoutEncoding:'buffer'});
      await writeFile(path.join(fixture.out,'native-host-ready.frame'),result.stdout);await writeFile(path.join(fixture.out,'native-host.stderr.txt'),result.stderr);
      report.setup.nativeHost={wallMs:result.wallMs,exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,outputLimit:result.outputLimit};
      if(result.exitCode!==0||result.signal||result.timedOut||result.outputLimit)throw Object.assign(Error('native initialization did not exit normally'),{kind:'bounded-stop'});
      report.setup.ready=decodeReadyFrame(result.stdout);
    }else await command('init',['init']);
    let lastScan,lastCoverage,stalls=0;report.setup.importPasses=[];report.setup.importCoverage=[];
    const expectedPaths=new Set(fixture.manifest.entries.map(e=>e.path));
    for(let pass=0;pass<maxImportPasses;pass++){
      const scan=await command(`import-${pass}`,['rescan','--max-entries','100000','--max-total-bytes',String(fixture.manifest.noteBytes+1024*1024),'--max-duration-ms',String(Math.min(5000,Math.floor(timeoutMs/2)))]);
      report.setup.importPasses.push(scan);
      if(scan.complete){lastScan=scan;break;}
      // Local-family inventory has a durable continuation. Legacy rescan starts
      // a new inventory; repeated legacy passes are not a continuation claim.
      if(!nativeHost)throw Object.assign(Error('legacy source import incomplete; no durable scan continuation'),{kind:'incomplete-import'});
      const listing=await command(`import-coverage-${pass}`,['list']);
      const coverage=liveImportCoverage(listing,expectedPaths);report.setup.importCoverage.push(coverage);
      const changed=importProgress(lastScan,scan,lastCoverage,coverage);
      stalls=changed?0:stalls+1;lastScan=scan;lastCoverage=coverage;
      if(stalls>=3)throw Object.assign(Error('bounded family import made no proven source or inventory progress'),{kind:'incomplete-import'});
    }
    if(!lastScan?.complete)throw Object.assign(Error('bounded source import pass limit reached'),{kind:'incomplete-import'});
    const list=await command('source-map',['list']);finalImportCoverage(list,expectedPaths,lastCoverage);
    const byPath=new Map(list.entries.filter(e=>e.kind==='file'&&!e.deleted).map(e=>[e.path,e]));
    assert.equal(byPath.size,fixture.manifest.entries.length,'source map must include every generated file');
    const mapping=fixture.manifest.entries.map(e=>{const actual=byPath.get(e.path);assert.ok(actual);assert.equal(typeof actual.id,'string');assert.equal(typeof actual.revision,'string');return {logicalId:e.logicalId,expectedSha256:e.sha256,entry:actual};});
    await writeFile(path.join(fixture.out,'source-map.json'),json(mapping));
    for(const expected of fixture.manifest.entries.filter(e=>e.noteIndex===0||e.noteIndex===notes-1||e.noteIndex===undefined)){
      const actual=await command(`authority-sample-${expected.logicalId}`,['read','--id',byPath.get(expected.path).id]);
      assert.deepEqual(actual.entry,byPath.get(expected.path));assert.equal(actual.encoding,'base64');
      const bytes=Buffer.from(actual.bytes,'base64');assert.equal(bytes.length,expected.bytes);assert.equal(sha256(bytes),expected.sha256);
      report.authoritySamples.push({logicalId:expected.logicalId,entry:actual.entry,sha256:sha256(bytes),bytes:bytes.length});
    }
    const cold=await command('cold-build',['document-index','build','--max-pumps','1000']);
    report.coldBuild=cold;if(!cold.published||!cold.buildComplete)throw Object.assign(Error('bounded derived build incomplete'),{kind:'incomplete-build'});
    const expectedSource=buildSource(cold);
    report.warmRestartStatus=await command('warm-restart-status',['document-index','status']);
    validateWarmStatus(report.warmRestartStatus,cold);
    for(let sample=0;sample<samples;sample++)for(const query of queries){
      const reply=await command(`query-${query.id}-${sample}`,['indexed-search',query.query,'--limit','1000','--max-pages','1000','--expected-snapshot',JSON.stringify(cold.snapshot)]);
      report.queries.push({...validateSearch(reply,query,notes,byPath,cold.snapshot,expectedSource),sample});
    }
    report.status='bounded-scenarios-verified';
  }catch(error){report.status=error.kind??'failed';report.failure={message:error.message,code:error.code??null,label:error.label??null};}
  finally{
    try{report.binary.finalSha256=sha256(await readFile(binary));report.binary.stableAtRunBoundaries=report.binary.sha256===report.binary.finalSha256;assert.equal(report.binary.stableAtRunBoundaries,true,'CLI executable changed during run');
      if(nativeHost){report.nativeHost.finalSha256=sha256(await readFile(nativeHost));report.nativeHost.stableAtRunBoundaries=report.nativeHost.sha256===report.nativeHost.finalSha256;assert.equal(report.nativeHost.stableAtRunBoundaries,true,'native host executable changed during run');}}
    catch(error){report.status='failed';report.binaryFailure=error.message;}
    try{await verifyFiles(fixture);report.filesystemSourcePreserved=true;}catch(error){report.filesystemSourcePreserved=false;report.status='failed';report.sourceFailure=error.message;}
    await writeFile(path.join(fixture.out,'report.json'),json(report));
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{out:{type:'string'},cli:{type:'string'},notes:{type:'string',default:'100'},'timeout-ms':{type:'string',default:'60000'},samples:{type:'string',default:'1'},'build-sha':{type:'string',default:'unknown'},'build-mode':{type:'string',default:'unknown'},stress:{type:'boolean',default:false},'native-host':{type:'string'},'max-import-passes':{type:'string',default:'32'}}});
  if(!values.out||!values.cli)throw Error('Usage: node cli.mjs --out NEW_DIRECTORY --cli BUILT_ZORID [--notes 10000 --samples 1]');
  const report=await runBaseline({out:values.out,binary:values.cli,notes:Number(values.notes),timeoutMs:Number(values['timeout-ms']),samples:Number(values.samples),buildSha:values['build-sha'],buildMode:values['build-mode'],stress:values.stress,nativeHost:values['native-host'],maxImportPasses:Number(values['max-import-passes'])});
  console.log(JSON.stringify({status:report.status,filesystemSourcePreserved:report.filesystemSourcePreserved,noteCount:report.noteCount,report:path.join(path.resolve(values.out),'report.json'),failure:report.failure}));
  if(report.status==='failed')process.exitCode=1;else if(report.status!=='bounded-scenarios-verified')process.exitCode=2;
}
