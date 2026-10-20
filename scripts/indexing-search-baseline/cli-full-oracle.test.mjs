import test from 'node:test';
import assert from 'node:assert/strict';
import {queries,literalOracle,noteSource} from './workload.mjs';
import {richLiteralExpression,validateRichStream} from './cli-full-oracle.mjs';

function fixture(count=2,query=queries[0]){
  const snapshot={localStoreId:'owned',generationEpoch:'epoch',generation:'1'},source={localStoreId:'owned',watermark:'9'};
  const expected=[...literalOracle(query,count)],byPath=new Map();
  const files=expected.map(row=>{
    const entry={id:row.logicalId,revision:'revision-'+row.logicalId,path:row.path,kind:'file',deleted:false};byPath.set(row.path,entry);
    const text=noteSource(Number(row.logicalId.slice(5)),count),start=text.lastIndexOf('\n',row.range.utf16[0]-1)+1,end=text.indexOf('\n',row.range.utf16[1]);
    const snippet=text.slice(start,end),range={bytes:[Buffer.byteLength(text.slice(0,start)),Buffer.byteLength(text.slice(0,end))],utf16:[start,end]};
    return {entry,chunk:0,lastChunk:true,occurrenceCount:1,locations:[{index:0,locator:{origin:'source',range:row.range,kind:'occurrence'},role:'occurrence',occurrences:1}],snippets:[{origin:'source',text:snippet,originRange:range,primaryLocationIndex:0,highlights:[{utf16:row.range.utf16.map(n=>n-start),locationIndices:[0]}],clippedBefore:false,clippedAfter:false}]};
  });
  const candidateFiles=count+3,pages=[];let seen=0;
  for(let offset=0;offset<Math.max(1,files.length);offset+=100){
    const chunk=files.slice(offset,offset+100);seen+=chunk.length;const complete=seen===files.length;
    const coverage={candidateFiles,evaluatedFiles:complete?candidateFiles:seen,unavailableFiles:0,scanComplete:complete,queryCoverageComplete:true};
    const totals={files:{relation:complete?'exact':'atLeast',value:seen},occurrences:{relation:complete?'exact':'atLeast',value:seen}};
    pages.push({version:1,ok:true,result:{operation:'indexed_query',event:'page',page:pages.length+1,hasNext:!complete,snapshot,source,coverageComplete:true,value:{snapshot,next:null,coverageComplete:true,spec:{query:richLiteralExpression(query),caseSensitive:true,sort:'nameAsc',context:'line',explain:false},scanComplete:complete,complete,outputComplete:true,coverage,totals,files:chunk}}});
  }
  const last=pages.at(-1).result,value=last.value;
  pages.push({version:1,ok:true,result:{operation:'indexed_query',event:'end',pages:pages.length,stopReason:'exhausted',hasNext:false,summary:{snapshot,source,coverageComplete:true,scanComplete:value.scanComplete,complete:value.complete,outputComplete:true,coverage:value.coverage,totals:value.totals}}});
  const options={query,count,byPath,snapshot,source,generationCoverage:true,candidateFiles};
  return {pages,options,encode:rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n'};
}
test('frozen rich expressions preserve substring, exact case and Unicode phrase semantics',()=>{
  assert.equal(richLiteralExpression(queries.find(q=>q.id==='substring')),'content:SUBSTR');
  assert.equal(richLiteralExpression(queries.find(q=>q.id==='short-substring')),'content:SU');
  assert.equal(richLiteralExpression(queries.find(q=>q.id==='case-sensitive')),'content:COMMON-MARKER');
  assert.equal(richLiteralExpression(queries.find(q=>q.id==='unicode')),'content:/café 😀/');
  assert.throws(()=>richLiteralExpression({id:'injected',query:'a OR b'}));
});
test('all eight frozen analytic membership/range scenarios have a complete NDJSON oracle',()=>{
  for(const query of queries){const f=fixture(100,query),result=validateRichStream(f.encode(f.pages),f.options);assert.equal(result.correctness,'complete-membership-order-source-ranges');assert.equal(result.verifiedFiles,[...literalOracle(query,100)].length);}
});
test('full pagination verifies beyond1000 and refuses a falsely complete1000-hit prefix',()=>{
  const f=fixture(1001);assert.equal(validateRichStream(f.encode(f.pages),f.options).verifiedFiles,1001);
  const prefix=structuredClone(f.pages);prefix.at(-2).result.value.files=[];assert.throws(()=>validateRichStream(f.encode(prefix),f.options));
});
test('missing pages, terminal, partial end, trailing output and truncated lines fail closed',()=>{
  const f=fixture(101);
  for(const mutate of [r=>r.splice(0,1),r=>r.pop(),r=>r.at(-1).result.stopReason='pageLimit',r=>r.at(-1).result.hasNext=true,r=>r.push(r.at(-1))]){
    const rows=structuredClone(f.pages);mutate(rows);assert.throws(()=>validateRichStream(f.encode(rows),f.options));
  }
  assert.throws(()=>validateRichStream(f.encode(f.pages).trimEnd(),f.options));
});
test('exact source identity, order, duplicate membership, UTF8 and UTF16 ranges are checked',()=>{
  const f=fixture(2,queries.find(q=>q.id==='unicode'));
  for(const mutate of [r=>r[0].result.snapshot.generation='other',r=>r[0].result.source.watermark='other',r=>r[0].result.value.files.reverse(),r=>r[0].result.value.files.push(r[0].result.value.files[0]),r=>r[0].result.value.files[0].entry.revision='other',r=>r[0].result.value.files[0].locations[0].locator.range.bytes[1]--,r=>r[0].result.value.files[0].locations[0].locator.range.utf16[1]--,r=>r[0].result.value.files[0].snippets[0].highlights[0].utf16[1]--]){
    const rows=structuredClone(f.pages);mutate(rows);assert.throws(()=>validateRichStream(f.encode(rows),f.options));
  }
});
test('final exact totals, complete query coverage and correct case flag cannot be forged',()=>{
  const f=fixture();
  for(const mutate of [r=>r.at(-1).result.summary.totals.files.relation='atLeast',r=>r.at(-1).result.summary.totals.occurrences.value++,r=>r.at(-1).result.summary.coverage.unavailableFiles=1,r=>r.at(-1).result.summary.outputComplete=false,r=>r[0].result.value.spec.caseSensitive=false,r=>r[0].result.value.spec.query='content:"common-marker"']){
    const rows=structuredClone(f.pages);mutate(rows);assert.throws(()=>validateRichStream(f.encode(rows),f.options));
  }
});
test('an exhausted page must be followed immediately by the end event',()=>{
  const f=fixture(),rows=structuredClone(f.pages),extra=structuredClone(rows[0]);extra.result.page=2;extra.result.value.files=[];rows.splice(1,0,extra);rows.at(-1).result.pages=2;
  assert.throws(()=>validateRichStream(f.encode(rows),f.options));
});
test('malformed intermediate counters, coverage flags and decreasing totals are rejected',()=>{
  const f=fixture(201);
  for(const mutate of [r=>r[0].result.value.coverage.evaluatedFiles=-1,r=>r[0].result.value.coverage.evaluatedFiles=null,r=>r[0].result.value.coverage.evaluatedFiles=1.5,r=>r[0].result.value.coverage.scanComplete=true,r=>r[0].result.value.coverage.queryCoverageComplete=false,r=>r[1].result.value.totals.files.value=99,r=>r[1].result.value.coverage.evaluatedFiles=99]){
    const rows=structuredClone(f.pages);mutate(rows);assert.throws(()=>validateRichStream(f.encode(rows),f.options));
  }
});
test('negative byte aliases and fractional snippet offsets fail despite matching text slices',()=>{
  const f=fixture(2,queries.find(q=>q.id==='unicode'));
  for(const mutate of [r=>r[0].result.value.files[0].snippets[0].originRange.bytes[0]-=Buffer.byteLength(noteSource(0,2)),r=>r[0].result.value.files[0].snippets[0].originRange.utf16[0]+=.1]){
    const rows=structuredClone(f.pages);mutate(rows);assert.throws(()=>validateRichStream(f.encode(rows),f.options));
  }
});
