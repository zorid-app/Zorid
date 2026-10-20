// Supplemental read-only acceptance on an already imported/built CLI baseline.
// node cli-full-oracle.mjs --fixture BASELINE_DIR --out NEW_DIR --cli BUILT_ZORID
// Every query is a new standalone process; pages within it retain one native pin.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {invoke,buildSource} from './cli.mjs';
import {queries,literalOracle,expectedCount,noteSource,sha256,json,checkCount,GENERATOR_VERSION} from './workload.mjs';

export function richLiteralExpression(query){
  assert.ok(queries.some(row=>row.id===query.id&&row.query===query.query),'Only the frozen workload literals are admitted');
  // Quoted content patterns impose word boundaries and would break SUBSTR/SU.
  // The one whitespace-containing literal uses the existing escaped regex API.
  return /\s/u.test(query.query)?'content:/'+query.query.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')+'/':'content:'+query.query;
}
function uint(value,max=Number.MAX_SAFE_INTEGER){assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=max,'Invalid unsigned bounded counter');return value;}
function range(value,length){assert.ok(Array.isArray(value)&&value.length===2);uint(value[0],length);uint(value[1],length);assert.ok(value[0]<value[1],'Empty or reversed source range');}
export class FullRichLiteralOracle{
  constructor({query,count,byPath,snapshot,source,generationCoverage,candidateFiles}){
    checkCount(count);Object.assign(this,{query,count,byPath,snapshot,source,generationCoverage,candidateFiles});
    assert.equal(typeof generationCoverage,'boolean');assert.ok(Number.isSafeInteger(candidateFiles)&&candidateFiles>=count);
    this.expected=literalOracle(query,count);this.verified=0;this.pages=0;this.ended=false;
  }
  consume(envelope){
    assert.equal(this.ended,false,'Output after terminal event');assert.equal(envelope.version,1);assert.equal(envelope.ok,true);
    const row=envelope.result;assert.equal(row.operation,'indexed_query');if(this.awaitingEnd)assert.equal(row.event,'end','Page after exhausted output');
    if(row.event==='end'){
      assert.ok(this.pages>0);assert.equal(row.pages,this.pages);assert.equal(row.stopReason,'exhausted');assert.equal(row.hasNext,false);
      assert.deepEqual(row.summary,this.lastSummary);assert.equal(row.summary.scanComplete,true);assert.equal(row.summary.complete,true);assert.equal(row.summary.outputComplete,true);
      assert.deepEqual(row.summary.coverage,{candidateFiles:this.candidateFiles,evaluatedFiles:this.candidateFiles,unavailableFiles:0,scanComplete:true,queryCoverageComplete:true});
      const total=expectedCount(this.query,this.count);assert.equal(this.verified,total,'Complete stream omitted expected matches');assert.equal(this.expected.next().done,true);
      assert.deepEqual(row.summary.totals,{files:{relation:'exact',value:total},occurrences:{relation:'exact',value:total}});
      this.ended=true;return;
    }
    assert.equal(row.event,'page');assert.equal(row.page,++this.pages);assert.equal(typeof row.hasNext,'boolean');
    assert.deepEqual(row.snapshot,this.snapshot);assert.deepEqual(row.source,this.source);assert.equal(row.coverageComplete,this.generationCoverage);
    const value=row.value;assert.deepEqual(value.snapshot,this.snapshot);assert.equal(value.next,null);assert.equal(value.coverageComplete,this.generationCoverage);
    assert.deepEqual(value.spec,{query:richLiteralExpression(this.query),caseSensitive:true,sort:'nameAsc',context:'line',explain:false});
    for(const field of ['scanComplete','complete','outputComplete'])assert.equal(typeof value[field],'boolean');
    assert.equal(value.complete,value.scanComplete&&value.coverage.queryCoverageComplete&&value.outputComplete);
    const coverage=value.coverage;assert.equal(coverage.candidateFiles,this.candidateFiles);uint(coverage.evaluatedFiles,this.candidateFiles);uint(coverage.unavailableFiles,coverage.evaluatedFiles);
    assert.equal(coverage.scanComplete,value.scanComplete);assert.equal(coverage.scanComplete,coverage.evaluatedFiles===this.candidateFiles);assert.equal(coverage.queryCoverageComplete,coverage.unavailableFiles===0);
    assert.ok(coverage.evaluatedFiles>=(this.lastSummary?.coverage.evaluatedFiles??0));
    for(const key of ['files','occurrences']){const total=value.totals[key];uint(total.value,expectedCount(this.query,this.count));assert.ok(total.value>=(this.lastSummary?.totals[key].value??0));assert.equal(total.relation,coverage.scanComplete&&coverage.queryCoverageComplete?'exact':'atLeast');}
    assert.equal(value.totals.files.value,value.totals.occurrences.value);
    assert.ok(Array.isArray(value.files));
    for(const file of value.files){
      const next=this.expected.next();assert.equal(next.done,false,'Unexpected extra or duplicate match');const expected=next.value,mapped=this.byPath.get(expected.path);
      assert.ok(mapped,'Missing committed source mapping');assert.deepEqual(file.entry,mapped,'Membership, order or exact source identity differs');
      // Each frozen marker occurs once per matching file, so no split chunks.
      assert.equal(file.chunk,0);assert.equal(file.lastChunk,true);assert.equal(file.occurrenceCount,1);assert.equal(file.locations.length,1);
      const location=file.locations[0];assert.equal(location.index,0);assert.equal(location.role,'occurrence');assert.equal(location.occurrences,1);
      assert.deepEqual(location.locator,{origin:'source',range:expected.range,kind:'occurrence'});
      const index=Number(expected.logicalId.slice(5)),source=noteSource(index,this.count),bytes=Buffer.from(source);
      assert.equal(bytes.subarray(...expected.range.bytes).toString('utf8'),this.query.query);
      assert.equal(source.slice(...expected.range.utf16),this.query.query);
      assert.equal(source.slice(0,expected.range.utf16[0]).split('\n').length-1,expected.line);
      assert.ok(file.snippets.length>0);
      for(const snippet of file.snippets){
        assert.equal(snippet.origin,'source');assert.equal(snippet.primaryLocationIndex,0);
        range(snippet.originRange.bytes,bytes.length);range(snippet.originRange.utf16,source.length);
        assert.equal(source.slice(...snippet.originRange.utf16),snippet.text);assert.equal(bytes.subarray(...snippet.originRange.bytes).toString('utf8'),snippet.text);
        assert.equal(snippet.highlights.length,1);const highlight=snippet.highlights[0];assert.deepEqual(highlight.locationIndices,[0]);
        range(highlight.utf16,snippet.text.length);assert.equal(snippet.text.slice(...highlight.utf16),this.query.query);
        assert.deepEqual(highlight.utf16.map(n=>n+snippet.originRange.utf16[0]),expected.range.utf16);
      }
      this.verified++;
    }
    assert.ok(value.totals.files.value>=this.verified);this.awaitingEnd=!row.hasNext;
    this.lastSummary={snapshot:row.snapshot,source:row.source,coverageComplete:row.coverageComplete,scanComplete:value.scanComplete,complete:value.complete,outputComplete:value.outputComplete,coverage:value.coverage,totals:value.totals};
    assert.equal(row.hasNext,!(value.scanComplete&&value.outputComplete));
  }
  finish(){assert.equal(this.ended,true,'Missing terminal event');return {queryId:this.query.id,pages:this.pages,verifiedFiles:this.verified,correctness:'complete-membership-order-source-ranges',snapshot:this.snapshot,source:this.source};}
}
export function validateRichStream(stdout,options){
  assert.ok(stdout.endsWith('\n'),'Truncated NDJSON output');const oracle=new FullRichLiteralOracle(options);
  for(const line of stdout.slice(0,-1).split('\n')){assert.ok(line.length>0);assert.ok(Buffer.byteLength(line)<=2*1024*1024);oracle.consume(JSON.parse(line));}
  return oracle.finish();
}

export async function runFullCliOracle({fixture,out,binary,timeoutMs=300000,maxPages=1000,maxPreparationPumps=1000,samples=1}){
  for(const [name,value,max]of [['timeoutMs',timeoutMs,300000],['maxPages',maxPages,100000],['maxPreparationPumps',maxPreparationPumps,100000],['samples',samples,20]])assert.ok(Number.isSafeInteger(value)&&value>=1&&value<=max,'Invalid '+name);
  fixture=await realpath(fixture);binary=await realpath(binary);assert.ok((await stat(binary)).isFile());out=path.resolve(out);await mkdir(out,{recursive:false});
  const report={schemaVersion:1,scope:'Supplemental standalone CLI rich NDJSON against frozen literal oracle; no source/index mutation',status:'running',fixture,out,binary:{path:binary},bounds:{timeoutMs,maxPages,maxPreparationPumps,samples,maxOutputBytes:64*1024*1024},queries:[],limitations:['Rich-query expressions are equivalent only for these frozen fixture literals; no general regex/literal dialect parity claim.','Fresh CLI process and native pin per query; not same-process retained-pin caching or20-query engine-only measurement.','Wall time includes subprocess startup, pin admission, preparation, output and harness handling.','Existing CLI presentation/page/line limits unchanged. Page limits, partial coverage, output truncation and missing end are failures.','This supplements an existing admitted/built fixture; it does not establish import, foreground, cancellation or full S1 acceptance.']};
  let manifest,baseline,before;
  async function verifySources(){for(const entry of manifest.entries){const bytes=await readFile(path.join(fixture,'vault',entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha256(bytes),entry.sha256,'Fixture source changed: '+entry.path);}}
  try{
    manifest=JSON.parse(await readFile(path.join(fixture,'manifest.json'),'utf8'));checkCount(manifest.noteCount);assert.equal(manifest.generator,GENERATOR_VERSION);
    baseline=JSON.parse(await readFile(path.join(fixture,'report.json'),'utf8'));assert.equal(baseline.fixtureHash,sha256(json(manifest)));assert.equal(baseline.noteCount,manifest.noteCount);assert.equal(baseline.coldBuild.published,true);assert.equal(baseline.coldBuild.buildComplete,true);
    const source=buildSource(baseline.coldBuild),snapshot=baseline.coldBuild.snapshot,mapping=JSON.parse(await readFile(path.join(fixture,'source-map.json'),'utf8'));
    const byPath=new Map(mapping.map(row=>[row.entry.path,row.entry])),mappingByPath=new Map(mapping.map(row=>[row.entry.path,row]));assert.equal(mapping.length,manifest.entries.length);assert.equal(byPath.size,manifest.entries.length);
    for(const expected of manifest.entries){const row=mappingByPath.get(expected.path);assert.ok(row);assert.equal(row.logicalId,expected.logicalId);assert.equal(row.expectedSha256,expected.sha256);assert.equal(row.entry.kind,'file');assert.equal(row.entry.deleted,false);}
    before=sha256(await readFile(binary));report.binary.sha256=before;report.fixtureHash=baseline.fixtureHash;report.noteCount=manifest.noteCount;report.snapshot=snapshot;report.source=source;
    await verifySources();const environment={...process.env,ZORID_LOCAL_DATA_DIR:path.join(fixture,'local-data')};delete environment.ZORID_IPC_ENDPOINT;delete environment.DISPLAY;
    for(let sample=0;sample<samples;sample++)for(const query of queries){
      const args=['--vault',path.join(fixture,'vault'),'indexed-query',richLiteralExpression(query),'--case-sensitive','--sort','name-asc','--context','line','--max-pages',String(maxPages),'--max-preparation-pumps',String(maxPreparationPumps),'--expected-snapshot',JSON.stringify(snapshot)];
      const result=await invoke(binary,args,{environment,timeoutMs});const label=`query-${query.id}-${sample}`;
      await writeFile(path.join(out,label+'.stdout.ndjson'),result.stdout);await writeFile(path.join(out,label+'.stderr.txt'),result.stderr);
      const observed={queryId:query.id,sample,args,exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,outputLimit:result.outputLimit,processWallMs:result.wallMs,stdoutBytes:Buffer.byteLength(result.stdout)};report.queries.push(observed);
      assert.equal(result.exitCode,0,'CLI query failed');assert.equal(result.signal,null);assert.equal(result.timedOut,false);assert.equal(result.outputLimit,false);assert.equal(result.stderr,'');
      Object.assign(observed,validateRichStream(result.stdout,{query,count:manifest.noteCount,byPath,snapshot,source,generationCoverage:baseline.coldBuild.observedIndex.coverageComplete,candidateFiles:manifest.entries.length}));
    }
    report.status='complete-oracles-verified';
  }catch(error){report.status='failed';report.failure={message:error.message};}
  finally{
    try{report.binary.finalSha256=sha256(await readFile(binary));assert.equal(report.binary.finalSha256,before,'CLI changed during run');await verifySources();report.filesystemSourcePreserved=true;}
    catch(error){report.status='failed';report.integrityFailure=error.message;report.filesystemSourcePreserved=false;}
    await writeFile(path.join(out,'report.json'),json(report));
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{fixture:{type:'string'},out:{type:'string'},cli:{type:'string'},'timeout-ms':{type:'string',default:'300000'},'max-pages':{type:'string',default:'1000'},'max-preparation-pumps':{type:'string',default:'1000'},samples:{type:'string',default:'1'}}});
  assert.ok(values.fixture&&values.out&&values.cli,'Require --fixture BASELINE_DIR --out NEW_DIR --cli BUILT_ZORID');
  const report=await runFullCliOracle({fixture:values.fixture,out:values.out,binary:values.cli,timeoutMs:Number(values['timeout-ms']),maxPages:Number(values['max-pages']),maxPreparationPumps:Number(values['max-preparation-pumps']),samples:Number(values.samples)});
  console.log(JSON.stringify({status:report.status,report:path.join(report.out,'report.json'),failure:report.failure}));if(report.status!=='complete-oracles-verified')process.exitCode=1;
}
